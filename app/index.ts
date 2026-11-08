import { registerRootComponent } from 'expo';

import App from './App';
// tarefa de GPS em segundo plano do motorista: precisa ser registrada antes de tudo
import './src/driver/backgroundLocation';
import { setupNotifications } from './src/push';

setupNotifications();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
