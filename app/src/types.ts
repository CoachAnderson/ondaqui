export interface LatLng { lat: number; lng: number }
export interface Place extends LatLng { address: string }

export type ServiceKind = 'corrida' | 'entrega' | 'particular' | 'frete' | 'paciente';

export interface Category {
  code: string; name: string; kind: ServiceKind; vehicle_type: 'carro' | 'moto' | 'utilitario';
  requires: string[]; description: string;
  base_fare_cents: number; per_km_cents: number; per_min_cents: number; min_fare_cents: number;
  per_hour_cents: number; extra_fee_cents: number;
}
export interface Plan { code: string; name: string; price_cents: number; period_days: number; commission_pct: number }

export interface Brand {
  slug: string; name: string; city_label: string; accent_color: string;
  categories: Category[]; plans: Plan[];
  /** a cidade exige o código por SMS ou WhatsApp no cadastro */
  phoneVerification?: boolean;
  /** algum motorista da cidade usa câmera de segurança */
  camerasInUse?: boolean;
}

export type Role = 'passenger' | 'driver';
export interface Session { token: string; tenant: string; user: { id: string; role: Role; name: string } }

export type RideStatus = 'scheduled' | 'requested' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';

export interface Ride {
  id: string;
  status: RideStatus;
  category: string;
  origin: Place;
  destination: Place;
  distanceKm: number;
  durationMin: number;
  priceCents: number;
  surge: number;
  paymentMethod: 'pix' | 'card' | 'cash' | 'convenio' | 'conta_loja';
  kind: ServiceKind;
  cod: null | { amountCents: number; method: string | null; status: string };
  store: null | { name: string; hasLogo: boolean };
  photos?: { pickup: boolean; dropoff: boolean };
  serviceName: string | null;
  scheduledFor: string | null;
  /** Modo família: a corrida é para um parente de quem pediu */
  family?: null | { name: string; relation: string; requestedBy: string | null; notes: string | null; phone?: string };
  /** cashback: usado nesta corrida, ganho ao concluir e quanto se paga ao motorista */
  cashback?: { usedCents: number; earnedCents: number; payCents: number };
  /** passageiro assinante do Clube: quanto deixou de pagar (desconto e dinâmica) */
  club?: { discountCents: number } | null;
  /** preferências da viagem do passageiro (música, conversa, ar) */
  tripPrefs?: { music: string; talk: string; ac: string; summary: string[] } | null;
  /** traçado da viagem pelas ruas (polyline); nulo sem o serviço de rotas */
  routePolyline?: string | null;
  hoursBooked: number | null;
  helpers: number;
  notes: string | null;
  delivery: null | { recipientName: string; recipientPhone: string | null; packageDesc: string; hasPickupPhoto: boolean };
  patient: null | { name: string; phone: string | null; companion: boolean; wheelchair: boolean; account: string };
  passenger: { name: string };
  driver: null | {
    name: string;
    vehicle: { plate: string; model: string; color: string };
    location: LatLng | null;
    hasPhoto?: boolean;
    hasVehiclePhoto?: boolean;
    /** câmera de segurança declarada pelo motorista */
    camera?: 'video' | 'video_audio' | null;
  };
  boardingCode?: string;
  deliveryCode?: string | null;
  shareToken?: string;
  cancelReason?: string | null;
  completedAt?: string | null;
}

export interface Offer {
  rideId: string;
  pickupDistanceKm: number | null;
  origin: Place;
  destination: Place;
  distanceKm: number;
  durationMin: number;
  priceCents: number;
  paymentMethod: 'pix' | 'card' | 'cash' | 'convenio' | 'conta_loja';
  codAmountCents?: number | null;
  kind?: ServiceKind;
  serviceName?: string | null;
  scheduledFor?: string | null;
  hoursBooked?: number | null;
  helpers?: number;
  notes?: string | null;
  packageDesc?: string | null;
  wheelchair?: boolean;
  companion?: boolean;
  /** Daqui Food: entrega do turno de entregador fixo (já paga pelo turno) */
  shift?: boolean;
}
