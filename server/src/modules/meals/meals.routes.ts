import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../../lib/api-schemas.js';
import { UnsupportedMediaTypeError, ValidationError } from '../../lib/errors.js';
import { prepareImage } from '../../lib/images.js';
import { todayIn } from '../../lib/local-date.js';
import { bucket } from '../../middleware/rate-limit.js';
import { toValidationError } from '../../middleware/validation.js';
import { requireUser } from '../auth/auth.plugin.js';
import type { UsersService } from '../users/users.service.js';
import type { MealsService } from './meals.service.js';
import {
  analyzeImageFieldsSchema,
  analyzeImageFormDocumentation,
  createMealSchema,
  mealListSchema,
  mealQuerySchema,
  mealSchema,
  parseMealSchema,
  parsedMealSchema,
  toMealResponse,
  updateMealSchema,
} from './meals.schema.js';

/**
 * `/api/meals`.
 *
 * Every response goes through `toMealResponse` with the user's preferences, which is
 * where `showCalories` is honoured — by omitting the field, not by hiding it.
 */
export async function mealsRoutes(
  app: FastifyInstance,
  options: {
    mealsService: MealsService;
    usersService: UsersService;
    /** `env.MAX_UPLOAD_BYTES` — the photo cap, enforced by multipart while streaming. */
    maxUploadBytes: number;
  },
): Promise<void> {
  const { mealsService, usersService, maxUploadBytes } = options;

  /** One preferences read per request, rather than one per meal being serialized. */
  const serializeOptions = async (userId: string): Promise<{ showCalories: boolean }> => {
    const profile = await usersService.getProfile(userId);
    return { showCalories: profile.preferences.showCalories };
  };

  app.post(
    '/',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { body: createMealSchema, response: { 201: mealSchema } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof createMealSchema>;

      const created = await mealsService.create(user.id, user.timezone, {
        mealType: body.mealType,
        items: body.items,
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.occurredAt !== undefined ? { occurredAt: body.occurredAt } : {}),
      });

      return reply.status(201).send(toMealResponse(created, await serializeOptions(user.id)));
    },
  );

  /**
   * Natural language to a reviewable draft. The parser reads the sentence; every number
   * in the response comes from the food database afterwards.
   */
  app.post(
    '/parse',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('ai-text') },
      schema: { body: parseMealSchema, response: { 200: parsedMealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const body = request.body as z.infer<typeof parseMealSchema>;

      const result = await mealsService.parseToDraft(
        user.id,
        user.timezone,
        body.text,
        body.mealType,
      );

      return {
        meal: toMealResponse(result.meal, await serializeOptions(user.id)),
        ambiguous: result.ambiguous,
        parser: result.parser,
      };
    },
  );

  /**
   * A meal photo to a reviewable draft. The same response as `/parse`, and every number on
   * it still comes from the food database.
   *
   * Registered in its own encapsulated scope, so multipart parsing exists for this one
   * route and no other: every other endpoint here takes JSON, and a JSON route that quietly
   * started accepting form uploads would be a surface nobody reviewed.
   *
   * The order is the security argument. Authentication is a preHandler, so it runs before
   * the handler reads a byte of the body — an unauthenticated upload is refused without
   * being buffered. Multipart then enforces size and part limits while streaming,
   * `prepareImage` decides what the bytes really are and re-encodes them, and only that
   * re-encoded, metadata-free copy goes anywhere.
   */
  await app.register(async (upload) => {
    await upload.register(multipart, {
      limits: {
        fileSize: maxUploadBytes,
        files: 1,
        // `mealType` and `description`, plus room for an unexpected field to reach
        // `.strict()` and be rejected as a 400 rather than tripping a limit as a 413.
        fields: 4,
        fieldSize: 2_048,
        fieldNameSize: 64,
        parts: 5,
      },
    });

    upload.post(
      '/analyze-image',
      {
        preHandler: upload.authenticate,
        config: {
          rateLimit: bucket('ai-vision'),
          skipBodySchema: true,
          multipartBody: analyzeImageFormDocumentation,
        },
        schema: { response: { 200: parsedMealSchema } },
      },
      async (request) => {
        const user = requireUser(request);

        if (!request.isMultipart()) {
          throw new UnsupportedMediaTypeError('Send the photo as multipart/form-data');
        }

        const form = await readImageForm(request);

        // An empty text box submits as an empty field: that is "no description", not an error.
        const description = form.fields['description'];
        if (typeof description === 'string' && description.trim() === '') {
          delete form.fields['description'];
        }

        const fields = analyzeImageFieldsSchema.safeParse(form.fields);
        if (!fields.success) throw toValidationError(fields.error, 'body');

        if (!form.image) {
          throw new ValidationError('image: a photo is required', [
            { path: 'image', issue: 'required' },
          ]);
        }

        // The filename is never read. The declared type is checked, then overruled by the
        // bytes, and only the re-encoded copy leaves this line.
        const image = await prepareImage(form.image.bytes, form.image.mimeType, {
          maxBytes: maxUploadBytes,
        });

        const result = await mealsService.analyzeImageToDraft(
          user.id,
          image,
          fields.data.description,
          fields.data.mealType,
        );

        return {
          meal: toMealResponse(result.meal, await serializeOptions(user.id)),
          ambiguous: result.ambiguous,
          parser: result.parser,
        };
      },
    );
  });

  app.get(
    '/today',
    {
      preHandler: app.authenticate,
      schema: { querystring: mealQuerySchema, response: { 200: mealListSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const query = request.query as z.infer<typeof mealQuerySchema>;

      const meals = await mealsService.listForDay(
        user.id,
        query.date ?? todayIn(user.timezone),
        query.includeDrafts === 'true',
      );

      const serialize = await serializeOptions(user.id);
      return { data: meals.map((meal) => toMealResponse(meal, serialize)) };
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.authenticate,
      schema: { params: idParamSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const meal = await mealsService.get(user.id, id);
      return toMealResponse(meal, await serializeOptions(user.id));
    },
  );

  /**
   * The user corrects a meal. Their edit pins every item to full confidence and teaches
   * the resolver, so the same phrase resolves correctly next time.
   */
  app.patch(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { params: idParamSchema, body: updateMealSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const body = request.body as z.infer<typeof updateMealSchema>;

      const updated = await mealsService.replaceItems(user.id, id, user.timezone, body.items);
      return toMealResponse(updated, await serializeOptions(user.id));
    },
  );

  app.post(
    '/:id/confirm',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write'), skipBodySchema: true },
      schema: { params: idParamSchema, response: { 200: mealSchema } },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      const confirmed = await mealsService.confirm(user.id, id, user.timezone);
      return toMealResponse(confirmed, await serializeOptions(user.id));
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.authenticate,
      config: { rateLimit: bucket('write') },
      schema: { params: idParamSchema, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = request.params as z.infer<typeof idParamSchema>;
      await mealsService.softDelete(user.id, id, user.timezone);
      return reply.status(204).send();
    },
  );
}

/**
 * Reads the form one part at a time, trusting nothing about it.
 *
 * An unexpected *file* is refused on sight, before its stream is read. Unknown text fields
 * are collected and left for `.strict()` to reject with a proper 400. A repeated field is
 * refused rather than resolved, because "last one wins" is how a proxy and a server come
 * to disagree about what a request said.
 */
async function readImageForm(request: FastifyRequest): Promise<{
  image?: { bytes: Buffer; mimeType: string };
  fields: Record<string, unknown>;
}> {
  const fields: Record<string, unknown> = {};
  let image: { bytes: Buffer; mimeType: string } | undefined;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'image' || image) {
        throw new ValidationError('Only one file, in the "image" field, is accepted', [
          { path: part.fieldname, issue: 'unexpected_file' },
        ]);
      }
      // Throws a 413 the moment the stream passes the configured size.
      image = { bytes: await part.toBuffer(), mimeType: part.mimetype };
      continue;
    }

    if (Object.hasOwn(fields, part.fieldname)) {
      throw new ValidationError(`${part.fieldname}: sent more than once`, [
        { path: part.fieldname, issue: 'duplicate' },
      ]);
    }
    if (part.valueTruncated) {
      throw new ValidationError(`${part.fieldname}: too long`, [
        { path: part.fieldname, issue: 'too_big' },
      ]);
    }
    fields[part.fieldname] = part.value;
  }

  return { ...(image ? { image } : {}), fields };
}
