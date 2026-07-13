const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  return r.json();
}
async function main() {
  // Get current deployment
  const q = await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id status createdAt meta instances{id status}}}}');
  const dep = q.data?.serviceInstance?.latestDeployment;
  console.log('Dep:', dep?.id, dep?.status, dep?.createdAt);
  console.log('Digest:', dep?.meta?.imageDigest);
  console.log('Instances:', JSON.stringify(dep?.instances));
  
  // Try raw logs query
  if (dep?.id) {
    const lr = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message severity timestamp}}');
    console.log('Log entries:', lr.data?.deploymentLogs?.length || 0);
    if (lr.data?.deploymentLogs?.length > 0) {
      lr.data.deploymentLogs.forEach(l => console.log(l.severity, (l.message||'').trim()));
    } else {
      console.log('Logs empty or error:', JSON.stringify(lr.errors||lr));
    }
  }
}
main().catch(e => console.error(e.message));
