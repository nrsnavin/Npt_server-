import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import OperationLock from '../models/OperationLock.js';
import ApiError from '../utils/ApiError.js';

/** Serialize a multi-document stock operation across API processes, including standalone MongoDB. */
export async function withOperationLock(key, work) {
  const token = randomUUID();
  try {
    await OperationLock.create({ _id: key, token, process: `${hostname()}:${process.pid}` });
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict('This order is being updated. Reload and try again. If this persists, ask an administrator to check interrupted operations.');
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    await OperationLock.deleteOne({ _id: key, token });
  }
}

export const withOrderLock = (orderId, handler) => async (req, res) =>
  withOperationLock(`order:${await orderId(req)}`, () => handler(req, res));
