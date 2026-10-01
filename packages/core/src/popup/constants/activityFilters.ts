/**
 * Activity filter options for the activity log UI.
 */
import type { ActivityFilter } from '../types';

export interface FilterOption {
  value: ActivityFilter;
  label: string;
}

export const ACTIVITY_FILTERS: FilterOption[] = [
  { value: 'all', label: 'All' },
  { value: 'auth', label: 'Auth' },
  { value: 'connection', label: 'Connection' },
  { value: 'tab', label: 'Tab' },
  { value: 'tool', label: 'Tool' },
  { value: 'error', label: 'Error' },
];
