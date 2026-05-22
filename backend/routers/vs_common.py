"""Shared Vertex AI Search (Discovery Engine) helpers."""

VS_LOCATION = "global"
VS_COLLECTION = "default_collection"

__all__ = [
    "VS_LOCATION",
    "VS_COLLECTION",
    "collection_path",
    "data_store_branch_path",
    "normalize_gcs_bucket",
    "engine_serving_config_path",
]


def collection_path(project_id: str) -> str:
    return (
        f"projects/{project_id}/locations/{VS_LOCATION}/collections/{VS_COLLECTION}"
    )


def data_store_branch_path(
    project_id: str, data_store_id: str, branch: str = "default_branch"
) -> str:
    """Branch resource under default_collection (matches Console / import API)."""
    return (
        f"projects/{project_id}/locations/{VS_LOCATION}/collections/{VS_COLLECTION}/"
        f"dataStores/{data_store_id}/branches/{branch}"
    )


def normalize_gcs_bucket(name: str) -> str:
    """Strip gs:// and path segments; return bare bucket id."""
    n = (name or "").strip()
    if n.lower().startswith("gs://"):
        n = n[5:]
    n = n.strip("/").split("/")[0]
    return n


def engine_serving_config_path(project_id: str, engine_id: str) -> str:
    """Serving config for the Search app (Engine) with linked data stores."""
    return (
        f"projects/{project_id}/locations/{VS_LOCATION}/collections/{VS_COLLECTION}/"
        f"engines/{engine_id}/servingConfigs/default_serving_config"
    )
