// iina-plugin-definition 0.99.4 declares `keyChainWrite`/`keyChainRead`, but IINA exports these
// names (see JavascriptAPIUtils.swift); calling the typed names fails at runtime.
declare namespace IINA {
  namespace API {
    interface Utils {
      keychainWrite(service: string, name: string, password: string): boolean;
      keychainRead(service: string, name: string): string | false;
    }
  }
}
