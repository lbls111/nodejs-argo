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
  const old = (await gql(`{
    serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      latestDeployment { id }
    }
  }`)).data.serviceInstance.latestDeployment;
  console.log(`Old: ${old.id}`);
  
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(r => setTimeout(r, 15000));
    const q = await gql(`{
      serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
        latestDeployment { id status createdAt meta }
      }
    }`);
    const dep = q.data?.serviceInstance?.latestDeployment;
    if (!dep) continue;
    
    const isNew = dep.id !== old.id;
    const msAgo = Math.floor((Date.now() - new Date(dep.createdAt).getTime()) / 1000);
    console.log(`[${attempt}] ${dep.id.substring(0,12)} status=${dep.status} ${msAgo}s ${isNew ? 'NEW' : 'old'}`);
    
    if (isNew && dep.status === 'SUCCESS') {
      console.log(`Digest: ${dep.meta?.imageDigest?.substring(0, 20)}`);
      await new Promise(r => setTimeout(r, 10000));
      
      const logsR = await gql(`{
        deploymentLogs(deploymentId:"${dep.id}", limit: 500) { message }
      }`);
      const logs = logsR.data?.deploymentLogs || [];
      const allLines = logs.map(l => (l.message||'')).filter(Boolean);
      
      let hasXrayStart = false, hasDead = false, hasPortError = false;
      allLines.forEach(m => {
        const s = m.substring(0, 500);
        if (m.includes('started PID')) { console.log(s); hasXrayStart = true; }
        if (m.includes('dead')||(m.includes('restart')&&m.includes('xray'))) { console.log(s); hasDead = true; }
        if (m.includes('address already in use')||m.includes('Failed to start')) { console.log(s); hasPortError = true; }
        if (m.includes('exit-proxy ready')||m.includes('Service started')||m.includes('EXIT')) console.log(s);
      });
      
      if (hasDead) console.log('\n*** xray DEAD ***');
      else if (hasPortError) console.log('\n*** PORT CONFLICT ***');
      else if (hasXrayStart) console.log('\n*** xray STARTED OK (check for death in next cycle) ***');
      else console.log('\n*** No xray status found ***');
      
      process.exit(hasDead || hasPortError ? 1 : 0);
    } else if (isNew && (dep.status==='FAILED'||dep.status==='CANCELED')) {
      console.log(`Deploy failed: ${dep.status}`);
      process.exit(1);
    }
  }
  console.log('Timeout');
}
main().catch(e => { console.error(e.message); process.exit(1); });
