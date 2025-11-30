import * as React from "react"

const MOBILE_BREAKPOINT = (typeof window !== 'undefined' ? (window as any).MOBILE_BREAKPOINT || 768 : 768)

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }

    // Initial check
    checkMobile()

    // Use ResizeObserver for better performance
    const resizeObserver = new ResizeObserver(checkMobile)
    resizeObserver.observe(document.body)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  return !!isMobile
}
