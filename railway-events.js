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
  // Logs might only be available during BUILD phase.
  // Let me try deploymentEvents and deploymentSessions
  const r = await gql(`{
    events: deploymentEvents(id: "d063bfa7-8729-4c24-9458-93bf1510c8d4", first: 100) {
      edges {
        node {
          type
          createdAt
          ... on DeploymentEvent {
            type
            createdAt
          }
        }
      }
    }
    sessions: deploymentSessions(deploymentId: "d063bfa7-8729-4c24-9458-93bf1510c8d4", first: 10) {
      edges {
        node {
          id
          status
          createdAt
        }
      }
    }
  }`);
  console.log(JSON.stringify(r, null, 2).substring(0, 5000));
}
main().catch(e => console.error(e.message));
