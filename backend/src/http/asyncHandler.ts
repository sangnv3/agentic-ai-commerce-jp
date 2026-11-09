import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 does not catch rejected promises: route every async handler's errors to the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
