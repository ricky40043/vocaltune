"""Durable, transactional inference quota. This is NOT a billing cap."""
import math
from datetime import datetime, timezone


class QuotaExceeded(Exception):
    pass


def billing_month():
    # UTC calendar month; deliberately independent of the container timezone.
    return datetime.now(timezone.utc).strftime("%Y-%m")


class FirestoreQuota:
    def __init__(self, project, collection, limit):
        from google.cloud import firestore
        self.db = firestore.Client(project=project)
        self.collection = collection
        self.limit = limit

    def reserve(self, seconds):
        from google.cloud import firestore
        ref = self.db.collection(self.collection).document(billing_month())

        @firestore.transactional
        def claim(transaction):
            data = ref.get(transaction=transaction).to_dict() or {}
            used = int(data.get("charged_seconds", 0))
            if used < 0 or used + seconds > self.limit:
                raise QuotaExceeded("Monthly inference quota exceeded")
            transaction.set(ref, {"charged_seconds": used + seconds}, merge=True)

        claim(self.db.transaction())
        return ref, seconds

    def finish(self, reservation, elapsed):
        from google.cloud import firestore
        ref, reserved = reservation
        # Never refund failed/crashed requests; caller only settles after success.
        actual = min(reserved, max(1, math.ceil(elapsed)))

        @firestore.transactional
        def settle(transaction):
            data = ref.get(transaction=transaction).to_dict()
            if not data or data["charged_seconds"] < reserved:
                raise RuntimeError("Quota ledger inconsistent")
            transaction.update(ref, {
                "charged_seconds": data["charged_seconds"] - reserved + actual,
                "completed_inference_seconds": firestore.Increment(actual),
            })

        settle(self.db.transaction())
