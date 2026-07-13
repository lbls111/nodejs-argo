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
  // Check Mutations for shellToken or exec
  const r = await gql(`{
    mt: __type(name: "Mutation") {
      fields { name args { name type { name kind } } }
    }
  }`);
  
  const mutations = r.data?.mt?.fields || [];
  const execMutations = mutations.filter(m => 
    m.name.includes('shell') || m.name.includes('exec') || m.name.includes('Exec')
  );
  console.log('Shell/Exec mutations:', execMutations.map(m => m.name));
  
  // Also check sandbox mutations
  const sandboxMuts = mutations.filter(m => m.name.includes('Sandbox') || m.name.includes('sandbox'));
  console.log('Sandbox mutations:', sandboxMuts.map(m => m.name));
}
main().catch(e => console.error(e.message));
