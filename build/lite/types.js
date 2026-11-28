/**
 * Durable vocabulary for Importer Lite.  These are deliberately smaller than
 * the legacy queue vocabulary: detail belongs in checkpoints and reasons, not
 * in ever more states.
 */
export const LITE_PRIORITIES = ['P0', 'STAFF', 'P1', 'P2'];
export const LITE_PRIORITY_RANK = {
    P0: 0,
    STAFF: 1,
    P1: 2,
    P2: 3,
};
export const LITE_TASK_STATES = ['READY', 'RUNNING', 'RETRY_WAIT', 'BLOCKED', 'DONE'];
