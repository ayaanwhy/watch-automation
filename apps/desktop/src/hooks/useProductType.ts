import { useCallback, useEffect, useState } from 'react'
import type { ProductType } from '../types/ipc'

export function useProductType() {
  const [productType, setProductTypeState] = useState<ProductType>('watch')

  useEffect(() => {
    window.api.invoke('prefs:load-product-type').then(stored => {
      if (stored !== null) setProductTypeState(stored)
    })
  }, [])

  const set = useCallback((value: ProductType) => {
    setProductTypeState(value)
    void window.api.invoke('prefs:save-product-type', value)
  }, [])

  return { productType, set }
}
