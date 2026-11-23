from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

import media_policy
from cloud_billing import BillingStatus

router = APIRouter()
provider = BillingStatus()


@router.get('/api/admin/cloud-billing')
async def cloud_billing_status(request: Request):
    if not media_policy.is_admin_request(request):
        raise HTTPException(401, '請先登入管理模式')
    try:
        result = await run_in_threadpool(provider.snapshot)
    except Exception:
        raise HTTPException(503, '費用資料暫時無法讀取，請稍後重試') from None
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})
