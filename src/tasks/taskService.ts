import type { Queries } from "../db/queries.js";
import type { Hex } from "../types.js";
import {
  createGatewayTaskId,
  hashGatewayTaskId,
  isGatewayTaskId,
} from "./taskId.js";

export interface DaskiTask {
  contextId: string;
  messageId: string | null;
  providerTaskId: string;
  serviceRef: Hex | null;
  providerA2AUrl: string;
  skillId: string;
  buyerTokenId: bigint;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface BeginTaskInput {
  contextId: string;
  messageId: string | null;
  serviceRef: Hex | null;
  providerA2AUrl: string;
  skillId: string;
  buyerTokenId: string;
}

export interface PendingDaskiTask {
  mappingId: string;
  taskId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class DaskiTaskService {
  constructor(
    private readonly queries: Queries,
    private readonly retentionSeconds: number,
  ) {}

  async begin(input: BeginTaskInput): Promise<PendingDaskiTask> {
    const taskId = createGatewayTaskId();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + this.retentionSeconds * 1000,
    );
    const mappingId = await this.queries.insertTaskMapping({
      ...input,
      publicIdHash: hashGatewayTaskId(taskId),
      expiresAt,
    });
    return { mappingId, taskId, createdAt, expiresAt };
  }

  async complete(
    mappingId: string,
    providerTaskId: string,
    status: string,
  ): Promise<void> {
    await this.queries.completeTaskMapping(mappingId, providerTaskId, status);
  }

  async abandon(mappingId: string | null): Promise<void> {
    if (!mappingId) return;
    await this.queries.deletePendingTaskMapping(mappingId);
  }

  async resolve(taskId: string): Promise<DaskiTask | null> {
    if (!isGatewayTaskId(taskId)) return null;
    return this.queries.completedTaskMapping(hashGatewayTaskId(taskId));
  }

  async recordStatus(taskId: string, status: string): Promise<void> {
    if (!isGatewayTaskId(taskId)) return;
    await this.queries.updateTaskMappingStatus(
      hashGatewayTaskId(taskId),
      status,
    );
  }
}
