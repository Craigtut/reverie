import type { AgentKind } from './types';

// Dispatch routing: the classifier's suggestion for where a spoken/typed task
// should land, mirrored from reverie_core::dispatch::DispatchRouting (camelCase
// over the wire). The dispatch UI renders it as an editable destination and the
// main window acts on it. See docs/product/core-experience/dispatch.md.

export type DispatchScope = 'general' | 'project';

export interface DispatchRouting {
  scope: DispatchScope;
  projectId?: string | null;
  topicId?: string | null;
  isNewTopic: boolean;
  newTopicTitle?: string | null;
  sessionTitle: string;
  confidence?: number | null;
}

// The payload the dispatch window hands the main window on confirm: the resolved
// routing, the chosen agent CLI, and the prompt to deliver.
export interface DispatchLaunchPayload {
  routing: DispatchRouting;
  agentKind: AgentKind;
  prompt: string;
}
