import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, newId, slugify } from '@roos/shared';

export type NodeType =
  | 'market'
  | 'company'
  | 'customer_segment'
  | 'technology'
  | 'product'
  | 'competitor'
  | 'pain_point'
  | 'regulation'
  | 'business_model'
  | 'experiment'
  | 'metric'
  | 'opportunity'
  | 'source';

export interface GraphNode {
  id: string;
  type: NodeType;
  key: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  srcId: string;
  dstId: string;
  type: string;
  weight: number;
  properties: Record<string, unknown>;
}

/**
 * Knowledge-graph abstraction. The PostgreSQL implementation stores a property graph in
 * kg_nodes / kg_edges and traverses it with recursive CTEs. A graph database (Neo4j, Neptune,
 * Memgraph…) can be added later by implementing this interface.
 */
export interface GraphStore {
  upsertNode(orgId: string, type: NodeType, key: string, label: string, properties?: Record<string, unknown>): Promise<string>;
  upsertEdge(orgId: string, srcId: string, dstId: string, type: string, opts?: { weight?: number; properties?: Record<string, unknown>; evidenceId?: string }): Promise<void>;
  neighborhood(orgId: string, nodeId: string, depth?: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  graph(orgId: string, opts?: { limit?: number; types?: NodeType[] }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  findNode(orgId: string, type: NodeType, key: string): Promise<GraphNode | null>;
}

export class PostgresGraphStore implements GraphStore {
  constructor(private db: Db) {}

  static key(label: string) {
    return slugify(label, 80);
  }

  async upsertNode(orgId: string, type: NodeType, key: string, label: string, properties: Record<string, unknown> = {}): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO kg_nodes (id, org_id, type, key, label, properties) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, type, key) DO UPDATE SET label = EXCLUDED.label, properties = kg_nodes.properties || EXCLUDED.properties, updated_at = now()
       RETURNING id`,
      [newId('node'), orgId, type, key, label.slice(0, 300), json(properties)],
    );
    return row!.id;
  }

  async upsertEdge(orgId: string, srcId: string, dstId: string, type: string, opts: { weight?: number; properties?: Record<string, unknown>; evidenceId?: string } = {}) {
    if (srcId === dstId) return;
    await this.db.query(
      `INSERT INTO kg_edges (id, org_id, src_id, dst_id, type, weight, properties, evidence_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, src_id, dst_id, type) DO UPDATE SET weight = kg_edges.weight + EXCLUDED.weight, properties = kg_edges.properties || EXCLUDED.properties`,
      [newId('edge'), orgId, srcId, dstId, type, opts.weight ?? 1, json(opts.properties ?? {}), opts.evidenceId ?? null],
    );
  }

  async findNode(orgId: string, type: NodeType, key: string): Promise<GraphNode | null> {
    const row = await this.db.one('SELECT id, type, key, label, properties FROM kg_nodes WHERE org_id = $1 AND type = $2 AND key = $3', [orgId, type, key]);
    return row ? camelize<GraphNode>(row) : null;
  }

  async neighborhood(orgId: string, nodeId: string, depth = 1) {
    const ids = await this.db.many<{ id: string }>(
      `WITH RECURSIVE walk(id, depth) AS (
         SELECT $2::text, 0
         UNION
         SELECT CASE WHEN e.src_id = w.id THEN e.dst_id ELSE e.src_id END, w.depth + 1
         FROM walk w JOIN kg_edges e ON (e.src_id = w.id OR e.dst_id = w.id) AND e.org_id = $1
         WHERE w.depth < $3
       ) SELECT DISTINCT id FROM walk LIMIT 500`,
      [orgId, nodeId, Math.min(depth, 3)],
    );
    return this.subgraph(orgId, ids.map((r) => r.id));
  }

  async graph(orgId: string, opts: { limit?: number; types?: NodeType[] } = {}) {
    const limit = Math.min(opts.limit ?? 300, 1000);
    const hasTypes = !!opts.types?.length;
    const params: unknown[] = hasTypes ? [orgId, opts.types, limit] : [orgId, limit];
    // Most-connected nodes first, so a bounded view shows the graph's hubs.
    const nodes = await this.db.many(
      `SELECT n.id FROM kg_nodes n
       LEFT JOIN (
         SELECT node_id, COUNT(*) AS degree FROM (
           SELECT src_id AS node_id FROM kg_edges WHERE org_id = $1
           UNION ALL SELECT dst_id FROM kg_edges WHERE org_id = $1
         ) x GROUP BY node_id
       ) d ON d.node_id = n.id
       WHERE n.org_id = $1 ${hasTypes ? 'AND n.type = ANY($2)' : ''}
       ORDER BY COALESCE(d.degree, 0) DESC, n.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return this.subgraph(orgId, nodes.map((n) => n.id as string));
  }

  private async subgraph(orgId: string, ids: string[]) {
    if (!ids.length) return { nodes: [], edges: [] };
    const nodes = (await this.db.many('SELECT id, type, key, label, properties FROM kg_nodes WHERE org_id = $1 AND id = ANY($2)', [orgId, ids])).map((r) => camelize<GraphNode>(r));
    const edges = (await this.db.many('SELECT id, src_id, dst_id, type, weight, properties FROM kg_edges WHERE org_id = $1 AND src_id = ANY($2) AND dst_id = ANY($2)', [orgId, ids])).map((r) =>
      camelize<GraphEdge>(r),
    );
    return { nodes, edges };
  }
}
