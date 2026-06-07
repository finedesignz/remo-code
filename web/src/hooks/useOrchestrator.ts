/**
 * useOrchestrator — Phase 31 hook for the one-per-session auto-dev orchestrator
 * task + its command rows. Mirrors `useSchedules`: token-gated `hubFetch`,
 * optimistic-ish list state with refetch on every mutation.
 *
 * Data-only: this configures the orchestrator task (lifecycle stage + rows). It
 * does not start, run, or queue anything (the controller path is flag-OFF).
 */
import { useCallback, useEffect, useState } from "react";
import { hubFetch } from "../lib/api";
import type { ScheduleRule } from "../lib/schedule-rules";

export type LifecycleStage = "development" | "beta" | "production-maintenance";

export interface OrchestratorTask {
  id: string;
  user_id: string;
  session_id: string | null;
  name: string;
  lifecycle_stage: LifecycleStage;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrchestratorRow {
  id: string;
  task_id: string;
  command: string;
  enabled: boolean;
  schedule_rule: ScheduleRule | null;
  frequency_label: string | null;
  micro_prompt: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AddRowInput {
  command?: string;
  micro_prompt?: string;
  enabled?: boolean;
  frequency_label?: string | null;
  schedule_rule?: ScheduleRule | null;
  sort_order?: number;
}

export interface RowPatch {
  enabled?: boolean;
  frequency_label?: string | null;
  micro_prompt?: string | null;
  schedule_rule?: ScheduleRule | null;
  sort_order?: number;
}

export interface UseOrchestrator {
  task: OrchestratorTask | null;
  rows: OrchestratorRow[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: () => Promise<void>;
  setStage: (stage: LifecycleStage) => Promise<void>;
  applyPreset: (stage: LifecycleStage, overwrite: boolean) => Promise<void>;
  addRow: (input: AddRowInput) => Promise<void>;
  updateRow: (rowId: string, patch: RowPatch) => Promise<void>;
  deleteRow: (rowId: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
}

export function useOrchestrator(
  token: string | null,
  sessionId: string | null,
): UseOrchestrator {
  const [task, setTask] = useState<OrchestratorTask | null>(null);
  const [rows, setRows] = useState<OrchestratorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!token || !sessionId) {
      setTask(null);
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const data = await hubFetch<{ task: OrchestratorTask | null; rows: OrchestratorRow[] }>(
        token,
        `/api/orchestrator-tasks/${sessionId}`,
      );
      setTask(data.task);
      setRows(data.rows ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "failed to load orchestrator");
    } finally {
      setLoading(false);
    }
  }, [token, sessionId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const create = useCallback(async () => {
    if (!token || !sessionId) return;
    const data = await hubFetch<{ task: OrchestratorTask; rows: OrchestratorRow[] }>(
      token,
      `/api/orchestrator-tasks/${sessionId}`,
      { method: "POST", json: {} },
    );
    setTask(data.task);
    setRows(data.rows ?? []);
  }, [token, sessionId]);

  const setStage = useCallback(
    async (stage: LifecycleStage) => {
      if (!token || !task) return;
      const data = await hubFetch<{ task: OrchestratorTask }>(
        token,
        `/api/orchestrator-tasks/${task.id}`,
        { method: "PATCH", json: { lifecycle_stage: stage } },
      );
      setTask(data.task);
    },
    [token, task],
  );

  const applyPreset = useCallback(
    async (stage: LifecycleStage, overwrite: boolean) => {
      if (!token || !task) return;
      const data = await hubFetch<{ rows: OrchestratorRow[] }>(
        token,
        `/api/orchestrator-tasks/${task.id}/apply-preset`,
        { method: "POST", json: { stage, overwrite } },
      );
      setRows(data.rows ?? []);
    },
    [token, task],
  );

  const addRow = useCallback(
    async (input: AddRowInput) => {
      if (!token || !task) return;
      await hubFetch(token, `/api/orchestrator-tasks/${task.id}/rows`, {
        method: "POST",
        json: input,
      });
      await refetch();
    },
    [token, task, refetch],
  );

  const updateRow = useCallback(
    async (rowId: string, patch: RowPatch) => {
      if (!token) return;
      const data = await hubFetch<{ row: OrchestratorRow }>(
        token,
        `/api/orchestrator-tasks/rows/${rowId}`,
        { method: "PATCH", json: patch },
      );
      setRows((prev) => prev.map((r) => (r.id === rowId ? data.row : r)));
    },
    [token],
  );

  const deleteRow = useCallback(
    async (rowId: string) => {
      if (!token) return;
      await hubFetch(token, `/api/orchestrator-tasks/rows/${rowId}`, {
        method: "DELETE",
        raw: true,
      });
      setRows((prev) => prev.filter((r) => r.id !== rowId));
    },
    [token],
  );

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      if (!token || !task) return;
      const data = await hubFetch<{ rows: OrchestratorRow[] }>(
        token,
        `/api/orchestrator-tasks/${task.id}/rows/reorder`,
        { method: "POST", json: { ordered_ids: orderedIds } },
      );
      setRows(data.rows ?? []);
    },
    [token, task],
  );

  return {
    task,
    rows,
    loading,
    error,
    refetch,
    create,
    setStage,
    applyPreset,
    addRow,
    updateRow,
    deleteRow,
    reorder,
  };
}
