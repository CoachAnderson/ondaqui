export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  color: string;
}

/** Linha desenhada no mapa: o caminho da viagem ou do motorista até o embarque */
export interface MapRoute {
  id: string;
  coords: { lat: number; lng: number }[];
  color: string;
  /** tracejada: caminho do motorista até o embarque */
  dashed?: boolean;
}

export interface RideMapProps {
  points: MapPoint[];
  routes?: MapRoute[];
  height?: number;
  /** segurar o dedo no mapa marca um ponto (ex.: destino) */
  onLongPress?: (p: { lat: number; lng: number }) => void;
}
