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
  const r = await gql(`query {
    deployments(input: {
      serviceId: "1ca52b80-31ac-47be-924d-196e21e4fee3",
      environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3"
    }) {
      edges {
        node {
          id
          status
          createdAt
          meta
          staticUrl
          url
          instances { id status }
        }
      }
    }
  }`);
  console.log(JSON.stringify(r, null, 2).substring(0, 5000));
}
main().catch(e => console.error(e.message));
