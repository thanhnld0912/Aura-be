/**
 * Fastify type augmentations owned by AURA.
 *
 * `skipBodySchema` is the only sanctioned way past the registration guard in
 * `middleware/validation.ts`. It exists for multipart routes (Phase 4's meal photo
 * upload), whose payload is validated by magic-byte sniffing rather than by Zod
 * (SECURITY.md §4). Keeping it typed here means the escape hatch is discoverable
 * rather than folded into an `any`.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    skipBodySchema?: boolean;
  }
}

export {};
