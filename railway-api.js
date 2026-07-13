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
  // Get latest deployment logs
  const r = await gql(`query {
    serviceInstance(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      id
      latestDeployment {
        id
        status
        createdAt
        meta { commitSha commitMsg }
        instances { id status }
        logs(limit: 300) {
          edges {
            node { severity message timestamp }
          }
        }
      }
    }
  }`);
  
  const dep = r.data?.serviceInstance?.latestDeployment;
  console.log('Deployment:', dep?.id, dep?.status, dep?.createdAt);
  console.log('Commit:', dep?.meta?.commitSha, dep?.meta?.commitMsg);
  console.log('Instances:', JSON.stringify(dep?.instances));
  
  // Show relevant log entries
  if (dep?.logs?.edges) {
    const logs = dep.logs.edges.map(e => e.node);
    // Show the last 80 log entries 
    console.log('\n=== Last 80 log entries ===');
    logs.slice(-80).forEach(l => {
      const msg = (l.message || '').substring(0, 300);
      console.log(msg);
    });
    
    // Search for xray, nginx, error
    console.log('\n=== xray/error lines ===');
    logs.filter(l => {
      const m = l.message || '';
      return m.includes('xray') || m.includes('restart') || m.includes('dead') || m.includes('error') || m.includes('Error') || m.includes('probe');
    }).forEach(l => console.log(l.timestamp, l.severity, (l.message||'').substring(0, 300)));
  }
}
main().catch(e => console.error(e.message));
