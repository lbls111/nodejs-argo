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
  console.log('Triggering redeploy...');
  await gql(`mutation {
    serviceInstanceRedeploy(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3")
  }`);
  
  // Find the NEW deployment by polling until we see a new ID
  const oldDep = (await gql(`{
    serviceInstance(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      latestDeployment { id createdAt }
    }
  }`)).data.serviceInstance.latestDeployment;
  console.log(`Old dep: ${oldDep.id.substring(0,8)} at ${oldDep.createdAt}`);
  
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 15000));
    
    const q = await gql(`{
      serviceInstance(serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
        latestDeployment { id status createdAt meta instances { id status } }
      }
    }`);
    const dep = q.data?.serviceInstance?.latestDeployment;
    if (!dep) continue;
    
    const msAgo = Math.floor((Date.now() - new Date(dep.createdAt).getTime()) / 1000);
    const isNew = dep.id !== oldDep.id;
    console.log(`[${attempt}] ${dep.id.substring(0,8)} status=${dep.status} ${msAgo}s ago ${isNew ? '(NEW)' : '(old)'}`);
    
    if (dep.status === 'SUCCESS' && dep.id !== oldDep.id) {
      console.log(`\n=== Image digest: ${dep.meta?.imageDigest?.substring(0, 20)} ===`);
      await new Promise(r => setTimeout(r, 5000));
      
      const logsR = await gql(`{
        deploymentLogs(deploymentId: "${dep.id}", limit: 500) { message }
      }`);
      const logs = logsR.data?.deploymentLogs || [];
      const allLines = logs.map(l => (l.message||'')).filter(Boolean);
      console.log(`Logs: ${allLines.length}`);
      
      allLines.forEach(m => {
        if (m.includes('xray')||m.includes('restart')||m.includes('dead')||m.includes('PID')||m.includes('copied')||m.includes('FATA')||m.includes('ERRO')||m.includes('bind')||m.includes('exit')||m.includes('probe')||m.includes('Service')||m.includes('started')||m.includes('Xray')||m.includes('Failed')) {
          console.log(m.substring(0, 500));
        }
      });
      
      const deadCount = allLines.filter(m => m.includes('restart') && m.includes('dead')).length;
      if (deadCount > 0) {
        console.log(`\n*** xray DIED ${deadCount}x ***`);
      } else {
        console.log('\n*** xray ALIVE - no death detected ***');
        // Check probe results
        const probes = allLines.filter(m => m.includes('probe'));
        probes.forEach(m => console.log(m));
      }
      process.exit(0);
    } else if ((dep.status === 'FAILED'||dep.status === 'CANCELED') && isNew) {
      console.log(`Deployment failed: ${dep.status}`);
      process.exit(1);
    }
  }
  console.log('Timeout');
}
main().catch(e => { console.error(e.message); process.exit(1); });
