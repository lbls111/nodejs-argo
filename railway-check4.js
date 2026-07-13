const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  return r.json();
}
async function main() {
  const q = await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id status createdAt meta instances{id status}}}}');
  const dep = q.data?.serviceInstance?.latestDeployment;
  console.log('Dep:', dep?.id?.substring(0,12), dep?.status);
  console.log('Image:', dep?.meta?.imageDigest?.substring(0,20));
  console.log('Instance:', dep?.instances?.[0]?.status);
  
  const lr = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message}}');
  const lines = (lr.data?.deploymentLogs||[]).map(l=>l.message||'');
  console.log('Logs:', lines.length);
  // Show last 50 lines
  lines.slice(-50).forEach(m => { if(m.trim()) console.log(m); });
}
main().catch(e => console.error(e.message));
