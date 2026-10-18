const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function groupRequest(){return {expectedOrgId:id(1),expectedActorId:id(2),publicationKey:id(190),requireAtomicPublication:true,id:null,communityId:null,name:'Original rule',scheduleTaskKey:'frame',cutoffOffsetDays:-14,cutoffAnchor:'start',sortOrder:0,categoryIds:[id(40),id(41)],expectedGroup:null,expectedCategoryVersions:[{id:id(40),definitionHash:'a'.repeat(64)},{id:id(41),definitionHash:'b'.repeat(64)}]}}
module.exports={groupRequest}
