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
    deployment(id: "d063bfa7-8729-4c24-9458-93bf1510c8d4") {
      id
      status
      createdAt
      meta
      url
      staticUrl
      instances { id status }
    }
    events: deploymentEvents(id: "d063bfa7-8729-4c24-9458-93bf1510c8d4", first: 50) {
      edges {
        node {
          id
          step
          createdAt
          payload { detail error reason }
        }
      }
    }
  }`);
  console.log(JSON.stringify(r, null, 2).substring(0, 10000));
}
main().catch(e => console.error(e.message));
