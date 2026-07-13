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
  // Use __schema to find the return type of deploymentLogs
  const r = await gql(`{
    __schema {
      types {
        name
        fields {
          name
          type { name kind }
        }
      }
    }
  }`);
  const types = r.data?.__schema?.types || [];
  // Find types related to "Log"
  const logTypes = types.filter(t => t.name.includes('Log') || t.name.includes('log'));
  console.log('Log-related types:', logTypes.map(t => t.name));
  
  // Also find the return type of deploymentLogs
  const queryType = types.find(t => t.name === 'Query');
  const depLogsField = queryType?.fields?.find(f => f.name === 'deploymentLogs');
  console.log('\ndeploymentLogs return type:', JSON.stringify(depLogsField?.type));
}
main().catch(e => console.error(e.message));
