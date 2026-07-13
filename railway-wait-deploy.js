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
  console.log('Polling deployment status...');
  for (let attempt = 0; attempt < 30; attempt++) {
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
    if (!dep) {
      console.log(`[${attempt}] no deployment data`);
      await new Promise(r => setTimeout(r, 15000));
      continue;
    }
    
    const msAgo = Math.floor((Date.now() - new Date(dep.createdAt).getTime()) / 1000);
    console.log(`[${attempt}] dep=${dep.id} status=${dep.status} created=${msAgo}s ago`);
    
    if (dep.status === 'SUCCESS') {
      console.log('=== Deployment SUCCESS ===');
      // Now get the logs
      const logsR = await gql(`{
        deploymentLogs(deploymentId: "${dep.id}", limit: 300) {
          message
          severity
          timestamp
        }
      }`);
      const logs = logsR.data?.deploymentLogs || [];
      console.log(`Logs count: ${logs.length}`);
      
      // Filter for key lines
      const interesting = ['xray', 'restart', 'dead', 'copied', 'recover', 'EXIT', 'exit', 'error', 'Error', 'probe', 'PID', 'Service started'];
      const filtered = logs.filter(l => {
        const m = l.message || '';
        return interesting.some(k => m.includes(k));
      });
      console.log('\n=== Relevant log lines ===');
      filtered.forEach(l => {
        console.log(l.message.substring(0, 500));
      });
      
      if (filtered.some(l => (l.message||'').includes('restart') && (l.message||'').includes('dead'))) {
        console.log('\n*** WARNING: xray still dying! ***');
      }
      
      process.exit(0);
    } else if (dep.status === 'FAILED' || dep.status === 'CANCELED' || dep.status === 'CRASHED') {
      console.log(`=== Deployment ${dep.status} ===`);
      process.exit(1);
    }
    
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log('Timed out waiting for deployment');
}
main().catch(e => { console.error(e.message); process.exit(1); });
