import { AsyncLocalStorage } from "async_hooks";
import express from "express";

export const asyncLocalStorage = new AsyncLocalStorage<{
  headers?: Record<string, string | string[] | undefined>;
  res?: express.Response;
  wwwAuthenticate?: string;
}>();
