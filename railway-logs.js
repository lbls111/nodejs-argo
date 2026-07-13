const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';

async function gql(query) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  return res.json();
}

async function main() {
  const r = await gql(`{
    deploymentLogs(deploymentId: "d063bfa7-8729-4c24-9458-93bf1510c8d4", limit: 300) {
      edges {
        node {
          severity
          message
          timestamp
        }
      }
    }
  }`);
  
  console.log('=== LAST 100 LINES ===');
  const edges = r.data?.deploymentLogs?.edges || [];
  const all = edges.map(e => e.node);
  const last100 = all.slice(-100);
  last100.forEach(l => {
    const msg = (l.message || '').substring(0, 400);
    console.log(msg);
  });
  
  console.log('\n=== xray/error/proxy/exit/restart LINES ===');
  all.filter(l => {
    const m = l.message || '';
    return m.includes('xray') || m.includes('restart') || m.includes('dead') || 
           m.includes('exit') || m.includes('probe') || m.includes('socks') ||
           m.includes('Error') || m.includes('error') || m.includes('nodeping') ||
           m.includes('pid') || m.includes('PID') || m.includes('custom');
  }).forEach(l => {
    const msg = (l.message || '').substring(0, 400);
    console.log(msg);
  });
}
main().catch(e => console.error(e.message));
