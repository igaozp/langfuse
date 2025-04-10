import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { prisma } from "@langfuse/shared/src/db";
import { isPrismaException } from "@/src/utils/exceptions";
import { logger, redis } from "@langfuse/shared/src/server";

import { type NextApiRequest, type NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  // CHECK AUTH
  const authCheck = await new ApiAuthService(
    prisma,
    redis,
  ).verifyAuthHeaderAndReturnScope(req.headers.authorization);
  if (!authCheck.validKey) {
    return res.status(401).json({
      message: authCheck.error,
    });
  }
  if (authCheck.scope.accessLevel !== "project" || !authCheck.scope.projectId) {
    return res
      .status(403)
      .json({ message: "Invalid API key. Are you using an organization key?" });
  }
  // END CHECK AUTH

  if (req.method === "GET") {
    try {
      // Do not apply rate limits as it can break applications on lower tier plans when using auth_check in prod

      const projects = await prisma.project.findMany({
        select: {
          id: true,
          name: true,
        },
        where: {
          id: authCheck.scope.projectId,
          // deletedAt: null, // here we want to include deleted projects and grey them in the UI.
        },
      });

      return res.status(200).json({
        data: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      });
    } catch (error) {
      logger.error(error);
      if (isPrismaException(error)) {
        return res.status(500).json({
          error: "Internal Server Error",
        });
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  } else {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/projects`,
    );
    return res.status(405).json({ message: "Method not allowed" });
  }
}
