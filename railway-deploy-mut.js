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
  // Find deployment-related mutations
  const r = await gql(`{
    mt: __type(name: "Mutation") {
      fields { name args { name type { name kind } } }
    }
  }`);
  const mutations = r.data?.mt?.fields || [];
  const deployMuts = mutations.filter(m => 
    m.name.includes('deploy') || m.name.includes('Deploy') || 
    m.name.includes('redeploy') || m.name.includes('Redeploy')
  );
  console.log('Deploy/related mutations:');
  deployMuts.forEach(m => {
    console.log(`  ${m.name}: args=${m.args.map(a => `${a.name}:${a.type.name||a.type.kind}`).join(', ')}`);
  });
}
main().catch(e => console.error(e.message));
