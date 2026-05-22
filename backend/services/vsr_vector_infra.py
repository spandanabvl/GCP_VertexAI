"""Provision Vertex AI Vector Search index + endpoint for RAG corpora."""

import re

from google.cloud import aiplatform

from config import PROJECT_ID, LOCATION


def _deployed_index_id(index_display_name: str) -> str:
    """GCP deployed_index_id: lowercase letters, digits, underscores; max 63 chars."""
    slug = re.sub(r"[^a-z0-9_]", "_", index_display_name.lower().replace(" ", "_"))
    slug = re.sub(r"_+", "_", slug).strip("_") or "vector"
    candidate = f"{slug}_deployed_index"
    return candidate[:63]


def provision_vector_search(index_display_name: str, endpoint_display_name: str) -> dict:
    """
    Create Matching Engine index + public endpoint, deploy index, return resource names.
    First deployment may take 20–30 minutes in GCP; this call starts deploy and returns.
    """
    aiplatform.init(project=PROJECT_ID, location=LOCATION)

    index = aiplatform.MatchingEngineIndex.create_tree_ah_index(
        display_name=index_display_name,
        description="Vertex AI RAG Vector Index",
        dimensions=768,
        approximate_neighbors_count=10,
        leaf_node_embedding_count=500,
        leaf_nodes_to_search_percent=7,
        distance_measure_type="DOT_PRODUCT_DISTANCE",
        feature_norm_type="UNIT_L2_NORM",
        index_update_method="STREAM_UPDATE",
    )

    index_endpoint = aiplatform.MatchingEngineIndexEndpoint.create(
        display_name=endpoint_display_name,
        public_endpoint_enabled=True,
    )

    deployed_index_id = _deployed_index_id(index_display_name)
    index_endpoint.deploy_index(
        index=index,
        deployed_index_id=deployed_index_id,
    )

    return {
        "index_resource_name": index.resource_name,
        "endpoint_resource_name": index_endpoint.resource_name,
        "deployed_index_id": deployed_index_id,
    }


def _is_not_found(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "not found" in msg or "404" in msg


def teardown_vector_search(
    index_resource_name: str,
    endpoint_resource_name: str,
    deployed_index_id: str = "",
) -> dict:
    """
    Undeploy index from endpoint, delete endpoint, then delete index.
    Idempotent: missing resources are treated as already removed.
    """
    aiplatform.init(project=PROJECT_ID, location=LOCATION)

    endpoint_deleted = False
    index_deleted = False

    endpoint = aiplatform.MatchingEngineIndexEndpoint(
        index_endpoint_name=endpoint_resource_name,
    )
    try:
        if deployed_index_id:
            try:
                endpoint.undeploy_index(deployed_index_id=deployed_index_id)
            except Exception as e:
                if not _is_not_found(e):
                    raise
        endpoint.delete(force=True, sync=True)
        endpoint_deleted = True
    except Exception as e:
        if not _is_not_found(e):
            raise

    index = aiplatform.MatchingEngineIndex(index_name=index_resource_name)
    try:
        index.delete(sync=True)
        index_deleted = True
    except Exception as e:
        if not _is_not_found(e):
            raise

    return {
        "endpoint_deleted": endpoint_deleted,
        "index_deleted": index_deleted,
    }
