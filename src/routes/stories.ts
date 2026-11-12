// Stories: the feed. Players, clubs, officials and leagues post training sessions, match
// highlights, matchday news and milestones, with photos; others like and comment.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Story, StoryComment, User } from '@/api/types';
import type * as P from '~/generated/prisma/client';
import { json, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isClubAdmin, isLeagueAdmin, notify } from '~/lib/repo';
import { storage } from '~/lib/storage';

const KINDS = ['highlight', 'training', 'matchday', 'news', 'milestone'] as const;
const PAGE = 20;

/** Club and league admins look after what's posted about their club or league. */
async function mayDelete(s: P.Story, viewer: User | undefined, orgOf: Map<string, string>) {
  if (!viewer) return false;
  if (s.authorId === viewer.id || viewer.staff) return true;
  if (s.teamId && isClubAdmin(viewer, s.teamId)) return true;
  const org = s.competitionId ? orgOf.get(s.competitionId) : undefined;
  return !!org && isLeagueAdmin(viewer, org);
}

async function toStories(rows: P.Story[], viewer: User | undefined): Promise<Story[]> {
  const [liked, comps] = await Promise.all([
    viewer ? prisma.storyLike.findMany({ where: { userId: viewer.id, storyId: { in: rows.map((r) => r.id) } }, select: { storyId: true } }) : Promise.resolve([]),
    prisma.competition.findMany({ where: { id: { in: rows.map((r) => r.competitionId).filter((x): x is string => !!x) } }, select: { id: true, orgId: true } }),
  ]);
  const orgOf = new Map(comps.map((c) => [c.id, c.orgId]));
  const likedIds = new Set(liked.map((l) => l.storyId));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      kind: r.kind as Story['kind'],
      text: r.text,
      photoUrls: json<string[]>(r.photoUrls) ?? [],
      teamId: r.teamId ?? undefined,
      matchId: r.matchId ?? undefined,
      competitionId: r.competitionId ?? undefined,
      likes: r.likes,
      comments: r.comments,
      liked: likedIds.has(r.id),
      canDelete: await mayDelete(r, viewer, orgOf),
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

const toComment = (c: P.StoryComment): StoryComment => ({ id: c.id, storyId: c.storyId, authorId: c.authorId, authorName: c.authorName, text: c.text, createdAt: c.createdAt.toISOString() });

async function story(id: string) {
  const s = await prisma.story.findUnique({ where: { id } });
  if (!s) throw notFound('Story');
  return s;
}

export async function storyRoutes(app: FastifyInstance) {
  // Newest first, 20 at a time; `before` pages back. Filter by club, league, match or author.
  app.get('/stories', async (req) => {
    const q = z.object({ teamId: z.string().optional(), competitionId: z.string().optional(), matchId: z.string().optional(), authorId: z.string().optional(), before: z.string().optional() }).parse(req.query);
    const rows = await prisma.story.findMany({
      where: { ...(q.teamId ? { teamId: q.teamId } : {}), ...(q.competitionId ? { competitionId: q.competitionId } : {}), ...(q.matchId ? { matchId: q.matchId } : {}), ...(q.authorId ? { authorId: q.authorId } : {}), ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: PAGE,
    });
    return toStories(rows, req.user);
  });

  // A photo for a story, uploaded before posting it.
  app.post('/stories/photos', async (req) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('Attach the photo as a file named image');
    if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw badRequest('Use a PNG, JPEG or WebP photo');
    const data = await file.toBuffer();
    if (data.length > 5 * 1024 * 1024) throw badRequest('Photos can be up to 5 MB');
    const key = `stories/${user.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${file.mimetype.split('/')[1].replace('jpeg', 'jpg')}`;
    await storage.put(key, data, file.mimetype);
    return { url: storage.publicUrl(key) };
  });

  app.post('/stories', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({
        kind: z.enum(KINDS),
        text: z.string().trim().min(1, 'Write something to go with it').max(1000, 'Keep it under 1,000 characters'),
        photoUrls: z.array(z.string().url()).max(4, 'Up to four photos').default([]),
        teamId: z.string().optional(),
        matchId: z.string().optional(),
        competitionId: z.string().optional(),
      })
      .parse(req.body);
    // Only photos uploaded to Ovalcast, so a story can't point at somewhere else.
    if (b.photoUrls.some((u) => !u.startsWith(storage.publicUrl('stories/')))) throw badRequest('Upload the photos first');
    if (b.teamId && !(await prisma.team.findUnique({ where: { id: b.teamId }, select: { id: true } }))) throw notFound('Club');
    // A story about a match is tagged with its league too, so it shows on the league's page.
    const match = b.matchId ? await prisma.match.findUnique({ where: { id: b.matchId }, select: { competitionId: true } }) : undefined;
    if (b.matchId && !match) throw notFound('Match');
    const row = await prisma.story.create({
      data: { id: newId('story'), authorId: user.id, authorName: user.name, kind: b.kind, text: b.text, photoUrls: toJson(b.photoUrls), teamId: b.teamId ?? null, matchId: b.matchId ?? null, competitionId: b.competitionId ?? match?.competitionId ?? null },
    });
    return (await toStories([row], user))[0];
  });

  app.delete<{ Params: { id: string } }>('/stories/:id', async (req, reply) => {
    const user = requireUser(req);
    const s = await story(req.params.id);
    const comp = s.competitionId ? await prisma.competition.findUnique({ where: { id: s.competitionId }, select: { id: true, orgId: true } }) : null;
    if (!(await mayDelete(s, user, new Map(comp ? [[comp.id, comp.orgId]] : [])))) throw forbidden('Only whoever posted it, or an admin of the club or league, can delete this');
    await prisma.$transaction([prisma.storyLike.deleteMany({ where: { storyId: s.id } }), prisma.storyComment.deleteMany({ where: { storyId: s.id } }), prisma.story.delete({ where: { id: s.id } })]);
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/stories/:id/like', async (req) => {
    const user = requireUser(req);
    const { liked } = z.object({ liked: z.boolean() }).parse(req.body);
    const s = await story(req.params.id);
    const had = await prisma.storyLike.findUnique({ where: { storyId_userId: { storyId: s.id, userId: user.id } } });
    if (liked && !had) {
      await prisma.$transaction([prisma.storyLike.create({ data: { storyId: s.id, userId: user.id } }), prisma.story.update({ where: { id: s.id }, data: { likes: { increment: 1 } } })]);
      if (s.authorId !== user.id) await notify(s.authorId, { kind: 'community', title: `${user.name} liked your story`, body: s.text.slice(0, 80), link: { pathname: '/stories', params: {} } });
    } else if (!liked && had) {
      await prisma.$transaction([prisma.storyLike.delete({ where: { storyId_userId: { storyId: s.id, userId: user.id } } }), prisma.story.update({ where: { id: s.id }, data: { likes: { decrement: 1 } } })]);
    }
    return (await toStories([await story(s.id)], user))[0];
  });

  app.get<{ Params: { id: string } }>('/stories/:id/comments', async (req) => (await prisma.storyComment.findMany({ where: { storyId: req.params.id }, orderBy: { createdAt: 'asc' }, take: 200 })).map(toComment));

  app.post<{ Params: { id: string } }>('/stories/:id/comments', async (req) => {
    const user = requireUser(req);
    const { text } = z.object({ text: z.string().trim().min(1, 'Write a comment').max(500, 'Keep it under 500 characters') }).parse(req.body);
    const s = await story(req.params.id);
    const [c] = await prisma.$transaction([
      prisma.storyComment.create({ data: { id: newId('cmt'), storyId: s.id, authorId: user.id, authorName: user.name, text } }),
      prisma.story.update({ where: { id: s.id }, data: { comments: { increment: 1 } } }),
    ]);
    if (s.authorId !== user.id) await notify(s.authorId, { kind: 'community', title: `${user.name} commented on your story`, body: text.slice(0, 80), link: { pathname: '/stories', params: {} } });
    return toComment(c);
  });
}
