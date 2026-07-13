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
  // Check the Log type
  const r = await gql(`{
    lt: __type(name: "Log") {
      fields { name type { name kind } }
    }
  }`);
  console.log('Log type:', JSON.stringify(r, null, 2));
  
  // Try deploymentLogs with 'Log' fields
  const r2 = await gql(`{
    deploymentLogs(deploymentId: "d063bfa7-8729-4c24-9458-93bf1510c8d4", limit: 100) {
      edges {
        node {
          ... on Log {
            message
            timestamp
            severity
          }
        }
      }
    }
  }`);
  console.log('\ndeploymentLogs result:', JSON.stringify(r2, null, 2).substring(0, 2000));
}
main().catch(e => console.error(e.message));
