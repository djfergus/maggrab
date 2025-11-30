import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mountStoreDevtool } from 'simple-zustand-devtools';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id