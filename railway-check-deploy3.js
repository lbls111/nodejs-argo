const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  return r.json();
}
async function main() {
  await new Promise(r => setTimeout(r, 30000));
  const lr = await gql('{deploymentLogs(deploymentId:"cb3cc4f2-45bc-4777-a9bd-a39256225e0e",limit:500){message}}');
  const lines = (lr.data?.deploymentLogs||[]).map(l => l.message || '');
  lines.forEach(m => { if (m.trim()) console.log(m); });
  
  const elf = lines.filter(m => m.includes('ELF'));
  const pids = lines.filter(m => m.includes('started PID'));
  const fail = lines.filter(m => m.includes('Exec')||m.includes('Failed')||m.includes('already in use')||m.includes('format'));
  const dead = lines.filter(m => m.includes('dead')||(m.includes('restart')&&m.includes('xray')));
  console.log('\n=== Summary ===');
  console.log('ELF verified copies:', elf.length);
  console.log('xray starts:', pids.length);
  console.log('failures:', fail.length);
  fail.forEach(m => console.log(' ', m.substring(0,200)));
  console.log('deaths:', dead.length);
}
main().catch(e => console.error(e.message));
