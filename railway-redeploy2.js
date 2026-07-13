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
  // Redeploy
  const r = await gql(`mutation {
    serviceInstanceRedeploy(
      serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e",
      environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"
    )
  }`);
  console.log('Redeploy result:', JSON.stringify(r.data));
  
  // Wait and poll
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise(r => setTimeout(r, 15000));
    
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
    if (!dep) continue;
    
    const msAgo = Math.floor((Date.now() - new Date(dep.createdAt).getTime()) / 1000);
    console.log(`[${attempt}] ${dep.id.substring(0,8)} status=${dep.status} ${msAgo}s ago`);
    
    if (dep.status === 'SUCCESS' && msAgo < 180) {
      // New deployment! Fetch logs
      await new Promise(r => setTimeout(r, 5000));
      const logsR = await gql(`{
        deploymentLogs(deploymentId: "${dep.id}", limit: 500) { message severity timestamp }
      }`);
      const logs = logsR.data?.deploymentLogs || [];
      console.log(`\n=== Logs (${logs.length} lines) ===`);
      
      const relevants = ['xray', 'restart', 'dead', 'copied', 'PID', 'tail', 'xray.log', 'FATA', 'ERRO', 'panic', 'exit', 'probe', 'Service started'];
      logs.forEach(l => {
        const m = l.message || '';
        if (relevants.some(k => m.includes(k))) {
          console.log(m.substring(0, 500));
        }
      });
      
      // Check if xray alive
      const restartDead = logs.filter(l => (l.message||'').includes('restart') && (l.message||'').includes('dead'));
      if (restartDead.length > 0) {
        console.log(`\n*** xray DEAD ${restartDead.length} times ***`);
      } else {
        console.log('\n*** NO xray death detected ***');
      }
      process.exit(0);
    } else if (dep.status === 'FAILED' || dep.status === 'CANCELED' || dep.status === 'CRASHED') {
      console.log(`Deployment failed: ${dep.status}`);
      process.exit(1);
    }
  }
  console.log('Timeout');
}
main().catch(e => { console.error(e.message); process.exit(1); });
