const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(query) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query})});
  return r.json();
}
async function main() {
  const depId = 'd31797bc-9ff6-43ac-b5e2-9c48bf96084d';
  const logsR = await gql(`{
    deploymentLogs(deploymentId:"${depId}", limit:500) { message }
  }`);
  const logs = logsR.data?.deploymentLogs || [];
  logs.forEach(l => { const m=(l.message||'').trim(); if(m) console.log(m); });
}
main().catch(e => console.error(e.message));
