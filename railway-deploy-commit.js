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
  // Check current deployment's image digest
  const q = await gql(`{
    serviceInstance(serviceId:"a30ba90a-cd02-414a-bea2-0a83d8ba656e", environmentId:"4f0d3f6e-9f7d-4a50-a433-99c18b370fd3") {
      latestDeployment { id status createdAt meta }
    }
  }`);
  const dep = q.data?.serviceInstance?.latestDeployment;
  console.log(`Current dep: ${dep?.id?.substring(0,12)} status=${dep?.status}`);
  console.log(`Image digest: ${dep?.meta?.imageDigest}`);
  
  // Try serviceInstanceDeploy with latestCommit to trigger a REAL deploy with new image
  const r = await gql(`mutation {
    result: serviceInstanceDeploy(
      serviceId: "a30ba90a-cd02-414a-bea2-0a83d8ba656e",
      environmentId: "4f0d3f6e-9f7d-4a50-a433-99c18b370fd3",
      latestCommit: true
    )
  }`);
  console.log(JSON.stringify(r, null, 2).substring(0, 500));
}
main().catch(e => console.error(e.message));
