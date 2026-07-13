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
  const r = await gql(`{
    dep: __type(name: "DeploymentEventPayload") {
      fields { name type { name kind } }
    }
  }`);
  console.log(JSON.stringify(r, null, 2).substring(0, 3000));
}
main().catch(e => console.error(e.message));
