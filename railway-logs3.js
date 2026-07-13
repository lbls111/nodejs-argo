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
      message
      severity
      timestamp
    }
  }`);
  console.log('Logs count:', r.data?.deploymentLogs?.length || 0);
  if (r.data?.deploymentLogs && r.data.deploymentLogs.length > 0) {
    r.data.deploymentLogs.slice(-100).forEach(l => {
      const msg = (l.message || '').substring(0, 400);
      if (msg.trim()) console.log(msg);
    });
  }
  console.log('\nFull response:', JSON.stringify(r, null, 2).substring(0, 3000));
}
main().catch(e => console.error(e.message));
