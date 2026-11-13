// Copied from project_aggregation modules/asset/lib/aster-accounts.ts at 0014655: asterKey and readAsterAccounts only,
// unchanged. mergeAsterRefresh and aggregateAster belong to syncing (A-4) and are left out.
import type { Asset, AsterAccount, Connection } from './types.ts';

export const asterKey=(id:string)=>id==='default'?'aster':'aster:'+id;
export function readAsterAccounts(saved:string|undefined, keys:string[], asset:Asset|undefined, connection:Connection):AsterAccount[]{
  const accounts:AsterAccount[]=saved!==undefined?JSON.parse(saved):asset&&(keys.includes('aster')||connection.lastSync)?[{
    ...connection,id:'default',name:'默认账号',value:asset.value,details:asset.details??[],updatedAt:asset.updatedAt,includeSpot:connection.scope.includes('现货'),
  }]:[];
  return accounts.map(account=>({...account,value:Number.isFinite(account.value)?account.value:null,configured:keys.includes(asterKey(account.id))}));
}
