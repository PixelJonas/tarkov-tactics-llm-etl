// GraphQL client for tarkov.dev API

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
  }>;
}

export class TarkovDevClient {
  private endpoint: string;

  constructor(endpoint = 'https://api.tarkov.dev/graphql') {
    this.endpoint = endpoint;
  }

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    if (result.errors) {
      throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
    }

    if (!result.data) {
      throw new Error('No data returned from GraphQL query');
    }

    return result.data;
  }

  async getAllMaps() {
    const query = `
      query GetMaps($lang: LanguageCode) {
        maps(lang: $lang) {
          id
          name
          spawns {
            categories
            sides
            position {
              x
              y
              z
            }
          }
        }
      }
    `;

    interface MapsResponse {
      maps: Array<{
        id: string;
        name: string;
        spawns: Array<{
          categories: string[];
          sides: string[];
          position: { x: number; y: number; z: number };
        }>;
      }>;
    }

    const result = await this.query<MapsResponse>(query, { lang: 'en' });
    return result.maps;
  }

  async getAllItems() {
    const query = `
      query GetItems($lang: LanguageCode) {
        items(lang: $lang) {
          id
          name
          shortName
          buyFor {
            source
            price
            currency
          }
          sellFor {
            source
            price
            currency
          }
        }
      }
    `;

    interface ItemsResponse {
      items: Array<{
        id: string;
        name: string;
        shortName: string;
        buyFor?: Array<{
          source: string;
          price: number;
          currency: string;
        }>;
        sellFor?: Array<{
          source: string;
          price: number;
          currency: string;
        }>;
      }>;
    }

    const result = await this.query<ItemsResponse>(query, { lang: 'en' });
    return result.items;
  }

  async getAllTasks() {
    const query = `
      query GetTasks($lang: LanguageCode) {
        tasks(lang: $lang) {
          id
          name
          objectives {
            id
            type
            description
            maps {
              id
              name
            }
          }
        }
      }
    `;

    interface TasksResponse {
      tasks: Array<{
        id: string;
        name: string;
        objectives: Array<{
          id: string;
          type: string;
          description: string;
          maps?: Array<{
            id: string;
            name: string;
          }>;
        }>;
      }>;
    }

    const result = await this.query<TasksResponse>(query, { lang: 'en' });
    return result.tasks;
  }
}