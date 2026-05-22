"""Tear down BigQuery + Vertex AI Feature Store resources for Feature Store RAG corpora."""

from google.cloud import bigquery
from sqlalchemy.orm import Session
from sqlalchemy import text

import vertexai
from vertexai.resources.preview import feature_store

from config import PROJECT_ID, LOCATION

vertexai.init(project=PROJECT_ID, location=LOCATION)


def _is_not_found(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "not found" in msg or "404" in msg


def _bq_table_in_use(db: Session, dataset_id: str, table_id: str, exclude_corpus: str) -> bool:
    n = db.execute(
        text("""
            SELECT COUNT(*) FROM fs_corpora
            WHERE corpus_name != :cn
              AND bq_dataset_id = :ds
              AND bq_table_id = :tbl
        """),
        {"cn": exclude_corpus, "ds": dataset_id, "tbl": table_id},
    ).scalar()
    return n > 0


def _feature_store_in_use(
    db: Session, fos_id: str, fv_id: str, exclude_corpus: str
) -> bool:
    n = db.execute(
        text("""
            SELECT COUNT(*) FROM fs_corpora
            WHERE corpus_name != :cn
              AND feature_online_store_id = :fos
              AND feature_view_id = :fv
        """),
        {"cn": exclude_corpus, "fos": fos_id, "fv": fv_id},
    ).scalar()
    return n > 0


def _online_store_in_use(db: Session, fos_id: str, exclude_corpus: str) -> bool:
    n = db.execute(
        text("""
            SELECT COUNT(*) FROM fs_corpora
            WHERE corpus_name != :cn
              AND feature_online_store_id = :fos
        """),
        {"cn": exclude_corpus, "fos": fos_id},
    ).scalar()
    return n > 0


def _delete_bq_table_and_dataset(dataset_id: str, table_id: str) -> dict:
    client = bigquery.Client(project=PROJECT_ID, location=LOCATION)
    ds_ref = bigquery.DatasetReference(PROJECT_ID, dataset_id)
    table_ref = ds_ref.table(table_id)

    table_deleted = False
    dataset_deleted = False

    try:
        client.delete_table(table_ref, not_found_ok=True)
        table_deleted = True
    except Exception as e:
        if not _is_not_found(e):
            raise

    try:
        client.delete_dataset(ds_ref, delete_contents=True, not_found_ok=True)
        dataset_deleted = True
    except Exception as e:
        if not _is_not_found(e):
            raise

    return {"table_deleted": table_deleted, "dataset_deleted": dataset_deleted}


def _delete_bq_rows_for_corpus(dataset_id: str, table_id: str, corpus_id: str) -> int:
    client = bigquery.Client(project=PROJECT_ID, location=LOCATION)
    table = f"`{PROJECT_ID}.{dataset_id}.{table_id}`"
    job = client.query(
        f"DELETE FROM {table} WHERE corpus_id = @corpus_id",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("corpus_id", "STRING", corpus_id),
            ],
        ),
    )
    job.result()
    return job.num_dml_affected_rows or 0


def _delete_feature_view(
    feature_view_resource: str | None,
    feature_online_store_id: str,
    feature_view_id: str,
) -> bool:
    try:
        if feature_view_resource:
            fv = feature_store.FeatureView(feature_view_resource)
        else:
            fos = feature_store.FeatureOnlineStore(feature_online_store_id)
            fv = fos.get_feature_view(feature_view_id)
        fv.delete(sync=True)
        return True
    except Exception as e:
        if _is_not_found(e):
            return False
        raise


def _delete_feature_online_store(feature_online_store_id: str) -> bool:
    try:
        fos = feature_store.FeatureOnlineStore(feature_online_store_id)
        fos.delete(force=True, sync=True)
        return True
    except Exception as e:
        if _is_not_found(e):
            return False
        raise


def teardown_fs_infra(
    db: Session,
    *,
    corpus_id: str,
    corpus_name: str,
    bq_dataset_id: str,
    bq_table_id: str,
    feature_online_store_id: str,
    feature_view_id: str,
    feature_view_resource: str | None,
) -> dict:
    """
    Remove BigQuery and Feature Store resources for a corpus.
    Skips shared resources still referenced by other rows in fs_corpora.
    """
    result: dict = {}

    bq_shared = _bq_table_in_use(db, bq_dataset_id, bq_table_id, corpus_name)
    fs_shared = _feature_store_in_use(
        db, feature_online_store_id, feature_view_id, corpus_name
    )

    if bq_shared:
        result["bq_rows_deleted"] = _delete_bq_rows_for_corpus(
            bq_dataset_id, bq_table_id, corpus_id
        )
        result["bq_table_deleted"] = False
        result["bq_dataset_deleted"] = False
    else:
        result["bigquery"] = _delete_bq_table_and_dataset(bq_dataset_id, bq_table_id)

    if fs_shared:
        result["feature_view_deleted"] = False
        result["feature_online_store_deleted"] = False
    else:
        result["feature_view_deleted"] = _delete_feature_view(
            feature_view_resource,
            feature_online_store_id,
            feature_view_id,
        )
        if _online_store_in_use(db, feature_online_store_id, corpus_name):
            result["feature_online_store_deleted"] = False
        else:
            result["feature_online_store_deleted"] = _delete_feature_online_store(
                feature_online_store_id
            )

    return result
