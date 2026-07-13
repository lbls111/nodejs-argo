const token = 'bde39c44-321e-4483-87e0-64c7b2ab178b';
async function gql(q) {
  const r = await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  return r.json();
}
async function main() {
  // Wait for more logs to accumulate
  await new Promise(r => setTimeout(r, 30000));
  const lr = await gql('{deploymentLogs(deploymentId:"0492fd0a-e1b0-45cf-afe8-ec9988987e54",limit:500){message}}');
  const lines = (lr.data?.deploymentLogs||[]).map(l => l.message || '');
  lines.forEach(m => { if (m.trim()) console.log(m); });
  
  // Check for xray status
  const starts = lines.filter(m => m.includes('started PID'));
  const fails = lines.filter(m => m.includes('Failed') || m.includes('address already in use'));
  const deaths = lines.filter(m => m.includes('dead') || (m.includes('restart') && m.includes('xray')));
  const aLive = lines.filter(m => m.includes('ALIVE') || m.includes('alive'));
  
  console.log('\n=== Summary ===');
  console.log(`xray starts: ${starts.length}`);
  console.log(`startup fails: ${fails.length}`);
  console.log(`xray deaths: ${deaths.length}`);
  deaths.forEach(m => console.log('  DEATH:', m.substring(0, 200)));
  fails.forEach(m => console.log('  FAIL:', m.substring(0, 200)));
}
main().catch(e => console.error(e.message));
