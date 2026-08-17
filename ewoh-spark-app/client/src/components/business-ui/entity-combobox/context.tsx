'use client';

import { createContext, useContext } from 'react';

import type { EntityComboboxContextValue } from '@client/src/components/business-ui/entity-combobox/types';

// CLI-331：泛型 Provider 上下文，丢弃 any。
const EntityComboboxContext = createContext<
  EntityComboboxContextValue | undefined
>(undefined);

export const EntityComboboxProvider = EntityComboboxContext.Provider;

export function useEntityComboboxContext(): EntityComboboxContextValue {
  const context = useContext(EntityComboboxContext);
  if (!context) {
    throw new Error(
      'useEntityComboboxContext must be used within EntityCombobox',
    );
  }
  return context;
}
