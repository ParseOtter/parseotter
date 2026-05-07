import { createApp } from './app/create-app'
import { cleanupExpiredTasks } from './app/tasks/expired-cleanup'
import { dispatchPendingTasks } from './app/tasks/modal-dispatch'
import { reconcileStuckTasks } from './app/tasks/task-reconciliation'
import { TaskCoordinator } from './durable-objects/task-coordinator'

const app = createApp()

export { TaskCoordinator }

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const now = new Date(event.scheduledTime)
        await dispatchPendingTasks({
          db: env.DB,
          env,
          now,
        })
        await reconcileStuckTasks({
          db: env.DB,
          bucket: env.R2_BUCKET,
          env,
          now,
        })
        await cleanupExpiredTasks({
          db: env.DB,
          bucket: env.R2_BUCKET,
          now,
        })
      })()
    )
  },
} satisfies ExportedHandler<CloudflareBindings>
