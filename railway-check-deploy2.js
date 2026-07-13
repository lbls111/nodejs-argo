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
  await new Promise(r => setTimeout(r, 30000));
  
  const r = await gql(`{
    serviceInstance(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      id
      latestDeployment {
        id
        status
        createdAt
        meta
        instances { id status }
      }
    }
  }`);
  const dep = r.data?.serviceInstance?.latestDeployment;
  console.log('Deployment:', dep?.id, dep?.status, dep?.createdAt);
  console.log('Meta image:', dep?.meta?.image);
  console.log('Meta digest:', dep?.meta?.imageDigest);
  console.log('Reason:', dep?.meta?.reason);
  
  // Get full logs
  const logsR = await gql(`{
    deploymentLogs(deploymentId: "${dep.id}", limit: 500) {
      message
      severity
      timestamp
    }
  }`);
  const logs = logsR.data?.deploymentLogs || [];
  console.log(`\nLogs count: ${logs.length}`);
  
  // Show last 120 lines
  logs.slice(-120).forEach(l => {
    const msg = (l.message || '').substring(0, 500);
    if (msg.trim()) console.log(msg);
  });
}
main().catch(e => console.error(e.message));
