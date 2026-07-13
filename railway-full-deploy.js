const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2', {method:'POST', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'}, body:JSON.stringify({query:q})});
  return r.json();
}
async function getOld() {
  const q = await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id}}}');
  return q.data?.serviceInstance?.latestDeployment?.id;
}
async function main() {
  const oldId = await getOld();
  console.log('Old dep:', oldId);
  
  // Wait for GHA build
  console.log('Waiting 240s for GHA build...');
  await new Promise(r => setTimeout(r, 240000));
  
  // Trigger deploy
  console.log('Deploying...');
  await gql('mutation{serviceInstanceDeploy(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3",latestCommit:true)}');
  
  // Poll for new deployment
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 15000));
    const q = await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id status createdAt meta}}}');
    const dep = q.data?.serviceInstance?.latestDeployment;
    if (!dep) continue;
    const isNew = dep.id !== oldId;
    const secs = Math.floor((Date.now() - new Date(dep.createdAt).getTime()) / 1000);
    console.log(`[${i}] ${dep.id.substring(0,12)} status=${dep.status} ${secs}s ${isNew ? 'NEW' : ''}`);
    
    if (isNew && dep.status === 'SUCCESS') {
      console.log(`Digest: ${dep.meta?.imageDigest?.substring(0,20)}`);
      
      // Wait a bit for logs to populate
      await new Promise(r => setTimeout(r, 15000));
      const lr = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message}}');
      const lines = (lr.data?.deploymentLogs||[]).map(l=>l.message||'');
      
      let ok = false, fail = false;
      lines.forEach(m => {
        const s = m.substring(0,400);
        if (m.includes('started PID') && !fail) { ok = true; console.log(s); }
        if (m.includes('bind: address already in use')) { fail = true; console.log(s); }
        if (m.includes('Failed to start')) { fail = true; console.log(s); }
        if (m.includes('restart') && m.includes('dead')) console.log('DEATH:', s);
        if (m.includes('Service started')) console.log(s);
      });
      
      if (fail) process.exit(1);
      if (ok) {
        console.log('\nxray STARTED OK');
        // Wait more to see if xray stays alive
        await new Promise(r => setTimeout(r, 90000));
        const lr2 = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message}}');
        const lines2 = (lr2.data?.deploymentLogs||[]).map(l=>l.message||'');
        const deaths = lines2.filter(m => m.includes('dead')||(m.includes('restart')&&m.includes('xray')));
        if (deaths.length > 0) {
          console.log(`\nxray DIED (${deaths.length}x) after initial start`);
          deaths.slice(0,3).forEach(m => console.log(m));
          process.exit(1);
        } else {
          console.log('xray ALIVE after 90s!');
          process.exit(0);
        }
      }
      process.exit(0);
    }
  }
  console.log('Timeout');
  process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
