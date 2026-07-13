const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  return r.json();
}
async function main() {
  const old = (await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id}}}')).data.serviceInstance.latestDeployment.id;
  console.log('Old:', old);
  
  // Trigger deploy
  await gql('mutation{serviceInstanceDeploy(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3",latestCommit:true)}');
  
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 15000));
    const q = await gql('{serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e",environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"){latestDeployment{id status createdAt meta}}}');
    const dep = q.data?.serviceInstance?.latestDeployment;
    if (!dep) continue;
    const isNew = dep.id !== old;
    if (isNew && dep.status === 'SUCCESS') {
      console.log('NEW dep:', dep.id, 'digest:', dep.meta?.imageDigest?.substring(0,20));
      await new Promise(r => setTimeout(r, 20000));
      const lr = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message}}');
      const lines = (lr.data?.deploymentLogs||[]).map(l => l.message || '');
      console.log('Logs:', lines.length);
      
      let ok = false, fail = false;
      lines.forEach(m => {
        const s = m.substring(0,400);
        if (m.includes('started PID')) { ok = true; if (i < 5) console.log('OK:', s); }
        if (m.includes('Exec format')||m.includes('Failed to start')||m.includes('already in use')) { fail = true; console.log('FAIL:', s); }
        if (m.includes('ELF verified')) console.log('COPY:', s);
        if (m.includes('restart')&&m.includes('dead')) console.log('DEATH:', s);
      });
      if (fail) { console.log('xray FAILED'); process.exit(1); }
      if (ok) {
        console.log('xray STARTED OK');
        // Wait 90s to verify xray stays alive
        await new Promise(r => setTimeout(r, 90000));
        const lr2 = await gql('{deploymentLogs(deploymentId:"'+dep.id+'",limit:500){message}}');
        const lines2 = (lr2.data?.deploymentLogs||[]).map(l => l.message || '');
        const deaths = lines2.filter(m => m.includes('dead')||(m.includes('restart')&&m.includes('xray')));
        if (deaths.length > 0) { console.log('DIED after 90s'); deaths.slice(0,3).forEach(m=>console.log(m)); process.exit(1); }
        else { console.log('ALIVE after 90s!'); process.exit(0); }
      }
      process.exit(0);
    }
    if (i % 4 === 0) console.log(`[${i}] waiting... (${dep?.status})`);
  }
  console.log('Timeout');
  process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
