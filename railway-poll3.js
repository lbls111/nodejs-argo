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
  await new Promise(r => setTimeout(r, 60000));
  
  const q = await gql(`{
    serviceInstance(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      id
      latestDeployment {
        id status createdAt meta
        instances { id status }
      }
    }
  }`);
  const dep = q.data?.serviceInstance?.latestDeployment;
  console.log('Dep ID:', dep?.id);
  console.log('Status:', dep?.status);
  console.log('Created:', dep?.createdAt);
  console.log('Digest:', dep?.meta?.imageDigest?.substring(0, 20));
  console.log('Instance:', dep?.instances?.[0]?.id, dep?.instances?.[0]?.status);
  
  const logsR = await gql(`{
    deploymentLogs(deploymentId: "${dep.id}", limit: 500) { message }
  }`);
  const logs = logsR.data?.deploymentLogs || [];
  console.log('Logs:', logs.length);
  logs.slice(-100).forEach(l => {
    const m = (l.message || '').substring(0, 500);
    if (m.trim()) console.log(m);
  });
}
main().catch(e => console.error(e.message));
